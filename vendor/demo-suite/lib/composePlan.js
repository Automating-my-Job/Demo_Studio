'use strict';
/**
 * composePlan.js — the compose stage's timing and camera maths. PURE, and
 * shared: Node builds a plan with it, and the stage page inlines this same
 * source to sample the plan every frame, so the tests cover what the film
 * draws. No require(), no Node APIs, no clocks.
 *
 * ===========================================================================
 * THE MODEL
 * ===========================================================================
 * A capture (recorder.js, capture mode) is a set of audited 2x stills of the
 * real app, each with named subject boxes. A timeline (authored per video)
 * says, per narration line: which still, the title words, and the MOVES:
 *   {focus: 'subject'}            ring the subject, frame the camera on it
 *   {frame: ['a','b'], focus}     frame the union, ring one inside it
 *   {focus: 'subject', keep: true} move the ring only; the camera holds
 *   {click: 'subject', then: 'still'}  the cursor arcs in, presses, and the
 *                                       still crossfades to the next state
 * each cued on a spoken word ({word: 'late'}) or at ms after the shot starts.
 * Planning turns that into tracks of eased segments the stage samples:
 * camera, ring, cursor, stills, titles, the hook words and the end card.
 *
 * The voice paces everything: each line starts `gapMs` after the previous
 * line's SPEECH ends (measured, not the clip's padded length), so pauses are
 * the same everywhere and never stack with transition time.
 */

/** A CSS-style cubic-bezier easing (x in [0,1] -> y). */
function cubicBezier(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const X = (t) => ((ax * t + bx) * t + cx) * t;
  const Y = (t) => ((ay * t + by) * t + cy) * t;
  return function (x) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let lo = 0, hi = 1, t = x;
    for (let i = 0; i < 40; i++) {
      const v = X(t);
      if (Math.abs(v - x) < 1e-6) break;
      if (v < x) lo = t; else hi = t;
      t = (lo + hi) / 2;
    }
    return Y(t);
  };
}

// Material 3 motion: standard for the camera, decelerate in, accelerate out.
const EASE = {
  standard: cubicBezier(0.2, 0, 0, 1),
  decel: cubicBezier(0.05, 0.7, 0.1, 1),
  accel: cubicBezier(0.3, 0, 0.8, 0.15),
  linear: (x) => Math.max(0, Math.min(1, x)),
};

/**
 * Output presets. win: the app window's width as a share of the frame;
 * fill: how much of the frame width a framed subject may take; maxZoom: the
 * taste limit (the 2x capture's resolution limit applies too); minText: a
 * framed subject's text is drawn at least this many screen px per app px,
 * so it reads at feed size (a whole-row frame at 1:1 was 0.7x: illegible).
 */
const ASPECTS = {
  '16:9': { W: 1920, H: 1080, win: 0.80, fill: 0.88, maxZoom: 2.4, minText: 1, titlePx: 40, pillBottom: 56, hookPx: 96 },
  '1:1': { W: 1080, H: 1080, win: 0.92, fill: 0.94, maxZoom: 3.4, minText: 1, titlePx: 38, pillBottom: 52, hookPx: 76 },
  '9:16': { W: 1080, H: 1920, win: 0.92, fill: 0.94, maxZoom: 3.6, minText: 1, titlePx: 44, pillBottom: 220, hookPx: 84 },
};

const lerp = (a, b, e) => a + (b - a) * e;

/** Frame geometry for one aspect: the window, its scale k (screen px per still px), the camera anchor. */
function layout(aspect, img, res) {
  const A = ASPECTS[aspect];
  if (!A) throw new Error('unknown aspect ' + aspect);
  const w = A.W * A.win;
  const h = w * img.h / img.w;
  const pillZone = A.pillBottom + Math.round(A.titlePx * 1.9) + 20;
  return Object.assign({}, A, {
    aspect: aspect,
    win: { x: (A.W - w) / 2, y: (A.H - h) / 2, w: w, h: h },
    k: w / img.w,
    res: res || 2,
    pillZone: pillZone,
    safeH: A.H - pillZone,
    anchor: { x: A.W / 2, y: Math.round((A.H - pillZone) / 2) + 10 },
  });
}

/** A still-px rect [l,t,r,b] in scene px. */
function sceneRect(r, L) {
  return [L.win.x + r[0] * L.k, L.win.y + r[1] * L.k, L.win.x + r[2] * L.k, L.win.y + r[3] * L.k];
}

/**
 * Keeps the camera inside the window: once zoomed past the frame, no canvas
 * shows at the edges; while the window is smaller than the view, it is
 * centred. screen = (scene - c) * s + anchor.
 */
function clampCamera(c, L) {
  const s = c.s;
  const fit = (v, a0, a1, lo, hi) => (hi - lo >= a0 + a1) ? Math.min(Math.max(v, lo + a0), hi - a1) : (lo + hi) / 2 - (a1 - a0) / 2;
  return {
    cx: fit(c.cx, L.anchor.x / s, (L.W - L.anchor.x) / s, L.win.x, L.win.x + L.win.w),
    cy: fit(c.cy, L.anchor.y / s, (L.H - L.anchor.y) / s, L.win.y, L.win.y + L.win.h),
    s: s,
  };
}

/** The establishing shot: the whole window, centred. */
function wideCamera(L) {
  return clampCamera({ cx: L.win.x + L.win.w / 2, cy: L.win.y + L.win.h / 2, s: 1 }, L);
}

/**
 * The camera that frames a still-px rect: as large as fill/height allow, and
 * never smaller than legible (minText), never past maxZoom or the capture's
 * pixels. When legibility wins over the fit, it centres on `focus` (the
 * ringed subject) so that is what stays in view.
 */
function frameFor(rect, L, zoom, focus) {
  const R = sceneRect(rect, L);
  const w = Math.max(1, R[2] - R[0]), h = Math.max(1, R[3] - R[1]);
  const cap = Math.min(L.maxZoom, L.res / L.k);
  const fit = Math.min(L.fill * L.W / w, 0.62 * L.safeH / h);
  let s = zoom || Math.max(fit, (L.minText || 0) / L.k);
  s = Math.max(1, Math.min(s, cap));
  const C = s > fit * 1.001 && focus ? sceneRect(focus, L) : R;
  return clampCamera({ cx: (C[0] + C[2]) / 2, cy: (C[1] + C[3]) / 2, s: s }, L);
}

/** Screen px of a scene point under a camera. */
function toScreen(p, cam, L) {
  return [(p[0] - cam.cx) * cam.s + L.anchor.x, (p[1] - cam.cy) * cam.s + L.anchor.y];
}

const MIX = {
  num: (a, b, e) => lerp(a, b, e),
  // Zoom interpolates in log space, so a 1x -> 2x push feels even.
  cam: (a, b, e) => ({ cx: lerp(a.cx, b.cx, e), cy: lerp(a.cy, b.cy, e), s: Math.exp(lerp(Math.log(a.s), Math.log(b.s), e)) }),
  ring: (a, b, e) => ({ rect: a.rect.map((v, i) => lerp(v, b.rect[i], e)), a: lerp(a.a, b.a, e) }),
  // A gentle arc, not a ruler line: the control point sits off the chord.
  arc: (a, b, e, seg) => {
    const bend = (seg && seg.bend) || 0;
    const mx = (a[0] + b[0]) / 2 - (b[1] - a[1]) * bend, my = (a[1] + b[1]) / 2 + (b[0] - a[0]) * bend;
    const u = 1 - e;
    return [u * u * a[0] + 2 * u * e * mx + e * e * b[0], u * u * a[1] + 2 * u * e * my + e * e * b[1]];
  },
};

/** The value of a track of sorted, non-overlapping eased segments at t (ms). */
function sample(segs, t, init, mix) {
  let v = init;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (t < s.t0) break;
    if (t >= s.t1) { v = s.to; continue; }
    return mix(s.from, s.to, (EASE[s.ease] || EASE.standard)((t - s.t0) / (s.t1 - s.t0)), s);
  }
  return v;
}

/** Appends a segment starting from the track's value at t0 (an unfinished segment is cut there). */
function push(segs, init, mix, t0, ms, to, ease, extra) {
  const from = sample(segs, t0, init, mix);
  const last = segs[segs.length - 1];
  if (last && last.t1 > t0) { last.to = from; last.t1 = Math.max(last.t0 + 1, t0); }
  segs.push(Object.assign({ t0: t0, t1: t0 + ms, from: from, to: to, ease: ease || 'standard' }, extra || {}));
}

function normWord(w) { return String(w).toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ''); }

/** Seconds into the clip where `needle` (one or more words) is spoken, or null. */
function wordAt(list, needle, nth) {
  const want = String(needle).split(/\s+/).map(normWord).filter(Boolean);
  let seen = 0;
  for (let i = 0; list && i + want.length <= list.length; i++) {
    let ok = true;
    for (let j = 0; j < want.length; j++) if (normWord(list[i + j].w) !== want[j]) { ok = false; break; }
    if (ok && ++seen === (nth || 1)) return list[i].s;
  }
  return null;
}

/**
 * The whole plan for one aspect. tl: the timeline; cap: capture.json; audio:
 * {KEY: {file, seconds, speech: [startSec, endSec]}}; words: {KEY: [{w,s,e}]}.
 */
function planComposition(tl, cap, audio, words, aspect) {
  const keys = Object.keys(cap.stills);
  if (!keys.length) throw new Error('the capture has no stills');
  const first = cap.stills[keys[0]];
  keys.forEach((k) => {
    if (cap.stills[k].width !== first.width || cap.stills[k].height !== first.height) throw new Error('stills differ in size: ' + k);
  });
  const L = layout(aspect, { w: first.width, h: first.height }, cap.scale);
  const gap = tl.gapMs === undefined ? 450 : tl.gapMs;
  const leadIn = tl.leadInMs === undefined ? 450 : tl.leadInMs;
  const tail = tl.tailMs === undefined ? 1500 : tl.tailMs;
  const preRoll = tl.preRollMs === undefined ? 300 : tl.preRollMs;

  // 1. The voice: speech-to-speech gaps, measured on each clip.
  const lines = [];
  let speechEnd = null;
  tl.shots.forEach((sh) => {
    const a = audio[sh.key];
    if (!a) throw new Error('no narration clip for ' + sh.key);
    const sp = a.speech || [0, a.seconds];
    const speechAt = speechEnd === null ? leadIn : speechEnd + (sh.gapMs === undefined ? gap : sh.gapMs);
    const atMs = Math.max(0, speechAt - sp[0] * 1000);
    lines.push({ key: sh.key, file: a.file, atMs: atMs, speechAt: atMs + sp[0] * 1000, speechEnd: atMs + sp[1] * 1000 });
    speechEnd = atMs + sp[1] * 1000;
  });
  const duration = Math.round(speechEnd + tail);

  // 2. Shots: each opens just before its line's first word.
  const shots = tl.shots.map((sh, i) => Object.assign({}, sh, {
    line: lines[i],
    t0: i === 0 ? 0 : Math.round(lines[i].speechAt - preRoll),
  }));
  shots.forEach((sh, i) => { sh.t1 = i + 1 < shots.length ? shots[i + 1].t0 : duration; });

  const subject = (still, name) => {
    const st = cap.stills[still];
    if (!st) throw new Error('unknown still ' + still);
    const r = st.subjects[name];
    if (!r) throw new Error('still ' + still + ' has no subject ' + name);
    return r;
  };
  const union = (still, names) => names.map((n) => subject(still, n)).reduce((u, r) => [Math.min(u[0], r[0]), Math.min(u[1], r[1]), Math.max(u[2], r[2]), Math.max(u[3], r[3])]);
  const cueAt = (sh, mv, fallback) => {
    if (mv.word) {
      const s = wordAt(words && words[sh.key], mv.word, mv.nth);
      if (s === null) throw new Error(sh.key + ': cue word "' + mv.word + '" is not in the spoken line');
      return Math.round(sh.line.atMs + s * 1000 - (mv.leadMs === undefined ? 200 : mv.leadMs));
    }
    if (mv.at !== undefined) return sh.t0 + mv.at;
    return fallback;
  };

  const wide = wideCamera(L);
  const P = {
    W: L.W, H: L.H, fps: tl.fps || 30, duration: duration, layout: L,
    camera: [], cam0: wide, ring: [], ring0: { rect: [0, 0, 0, 0], a: 0 },
    cursor: [], cursor0: [0, 0], cursorAlpha: [], presses: [],
    still: [], windowAlpha: [], titles: [], hook: null, end: null,
    audio: lines.map((l) => ({ key: l.key, file: l.file, atMs: Math.round(l.atMs) })),
    beats: lines.map((l) => ({ key: l.key, atMs: Math.round(l.speechAt) })),
  };
  let still = null;
  let appStarted = false;
  // Every move settles into a slow push (4% over 8 s), so a held frame is
  // never dead; the next move or cut starts from wherever the drift got to.
  const camMove = (t, ms, to) => {
    push(P.camera, wide, MIX.cam, t, ms, to);
    push(P.camera, wide, MIX.cam, t + ms, 8000, clampCamera({ cx: to.cx, cy: to.cy, s: to.s * 1.04 }, L), 'linear');
  };

  shots.forEach((sh, i) => {
    const type = sh.type || 'app';
    if (type === 'title') {
      const text = String(sh.text || '');
      const list = (words && words[sh.key]) || [];
      const toks = text.split(/\s+/).filter(Boolean);
      // Each word appears as it is spoken (Whisper's times when they line up, else evenly).
      const times = toks.map((w, j) => list.length === toks.length ? sh.line.atMs + list[j].s * 1000
        : sh.line.speechAt + (sh.line.speechEnd - sh.line.speechAt) * j / toks.length);
      // It lifts away just before the app arrives, never over it.
      P.hook = { t0: sh.t0, t1: sh.t1 - 250, lockup: sh.lockup || '', words: toks.map((w, j) => ({ w: w, t: Math.round(times[j] - 120) })) };
      return;
    }
    if (type === 'end') {
      if (appStarted) push(P.windowAlpha, 0, MIX.num, sh.t0, 500, 0, 'accel');
      // Lines may land on their spoken words ({word}), else they stagger in.
      P.end = { t0: sh.t0, lines: (sh.lines || []).map((l, j) => Object.assign({}, l, {
        t: l.word ? Math.max(sh.t0, cueAt(sh, l, 0)) : sh.t0 + 150 + 120 * j })) };
      return;
    }
    // An app shot.
    if (!sh.still || !cap.stills[sh.still]) throw new Error(sh.key + ': unknown still ' + sh.still);
    if (!appStarted) {
      push(P.windowAlpha, 0, MIX.num, sh.t0 + 120, 750, 1, 'decel');
      appStarted = true;
    }
    if (still !== sh.still) {
      P.still.push({ t: sh.t0, key: sh.still, fade: still === null ? 0 : 380 });
      camMove(sh.t0, still === null ? 1 : 600, wide);
      still = sh.still;
    }
    if (sh.title) P.titles.push({ t0: sh.t0 + 250, t1: sh.t1 - 120, text: sh.title });

    let t = sh.t0 + 600;
    let lastPress = null;
    let cursorOn = false;
    (sh.moves || []).forEach((mv) => {
      t = cueAt(sh, mv, t);
      if (mv.click) {
        const r = subject(still, mv.click);
        const cam = sample(P.camera, t, wide, MIX.cam);
        const target = [(sceneRect(r, L)[0] + sceneRect(r, L)[2]) / 2, (sceneRect(r, L)[1] + sceneRect(r, L)[3]) / 2];
        const glide = mv.glideMs || 650;
        if (mv.frame) camMove(t - glide - 200, 800, frameFor(union(still, [].concat(mv.frame)), L, mv.zoom, r));
        if (!cursorOn) {
          const start = [target[0] + 150 / cam.s, target[1] + 120 / cam.s];
          // The pointer is placed before it fades in, never drawn at the origin.
          push(P.cursor, P.cursor0, MIX.arc, t - glide - 240, 1, start, 'linear');
          push(P.cursor, P.cursor0, MIX.arc, t - glide - 239, 239, start, 'linear');
          push(P.cursorAlpha, 0, MIX.num, t - glide - 220, 200, 1, 'decel');
          cursorOn = true;
        }
        push(P.cursor, P.cursor0, MIX.arc, t - glide, glide, target, 'standard', { bend: 0.16 });
        P.presses.push(t);
        push(P.ring, P.ring0, MIX.ring, t - 120, 200, Object.assign({}, sample(P.ring, t - 120, P.ring0, MIX.ring), { a: 0 }), 'accel');
        if (mv.then) {
          if (!cap.stills[mv.then]) throw new Error(sh.key + ': unknown still ' + mv.then);
          P.still.push({ t: t + 90, key: mv.then, fade: 260 });
          still = mv.then;
        }
        lastPress = t;
        t += 400;
      }
      if (mv.focus || mv.frame) {
        if (!mv.click && !mv.keep) {
          const rect = mv.frame ? union(still, [].concat(mv.frame)) : subject(still, mv.focus);
          camMove(t, mv.ms || 850, frameFor(rect, L, mv.zoom, mv.focus ? subject(still, mv.focus) : null));
        }
        if (mv.focus) {
          const to = { rect: subject(still, mv.focus), a: 1 };
          const cur = sample(P.ring, t, P.ring0, MIX.ring);
          if (cur.a < 0.05) push(P.ring, P.ring0, MIX.ring, t, 1, { rect: to.rect, a: 0 }, 'linear');
          push(P.ring, P.ring0, MIX.ring, t + 1, mv.ms || 650, to);
        }
      }
      if (mv.wide) camMove(t, mv.ms || 850, wide);
    });
    if (lastPress !== null) {
      const off = Math.min(lastPress + 700, sh.t1 - 300);
      push(P.cursorAlpha, 0, MIX.num, off, 300, 0, 'accel');
    }
    // The ring leaves before the next page arrives.
    const next = shots[i + 1];
    if (!next || next.still !== still) {
      const cur = sample(P.ring, sh.t1 - 260, P.ring0, MIX.ring);
      if (cur.a > 0) push(P.ring, P.ring0, MIX.ring, sh.t1 - 260, 240, { rect: cur.rect, a: 0 }, 'accel');
    }
  });
  if (!P.still.length) throw new Error('the timeline has no app shot');
  return P;
}

/** Every text the stage will draw (for the overlay safety check). */
function overlayTexts(tl) {
  const out = [];
  tl.shots.forEach((sh) => {
    if (sh.text) out.push(sh.text);
    if (sh.lockup) out.push(sh.lockup);
    if (sh.title) out.push(sh.title);
    (sh.lines || []).forEach((l) => out.push(l.text));
  });
  return out;
}

if (typeof module !== 'undefined') {
  module.exports = { cubicBezier, EASE, ASPECTS, layout, sceneRect, clampCamera, wideCamera, frameFor, toScreen, MIX, sample, push, wordAt, planComposition, overlayTexts };
}
