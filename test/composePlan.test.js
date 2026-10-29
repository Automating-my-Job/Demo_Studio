'use strict';
const test = require('node:test');
const assert = require('node:assert');
const C = require('../vendor/demo-suite/lib/composePlan.js');

const STILL = { width: 1920, height: 982, subjects: { row: [250, 762, 1670, 807], pill: [1556, 768, 1654, 800], card: [100, 100, 700, 500] } };
const CAP = { scale: 2, stills: { a: STILL, b: Object.assign({}, STILL) } };
const AUDIO = {
  HOOK: { file: 'h.wav', seconds: 1.6, speech: [0.25, 1.4] },
  ONE: { file: 'o.wav', seconds: 5, speech: [0.3, 4.7] },
  CTA: { file: 'c.wav', seconds: 4, speech: [0.2, 3.8] },
};
const WORDS = {
  HOOK: [{ w: 'Where', s: 0.25 }, { w: 'is', s: 0.5 }, { w: 'it?', s: 0.7 }],
  ONE: [{ w: 'Products', s: 0.3 }, { w: 'that', s: 1.0 }, { w: 'lose', s: 2.0 }, { w: 'more', s: 2.4 }, { w: 'why.', s: 4.2 }],
};
const TL = {
  shots: [
    { key: 'HOOK', type: 'title', text: 'Where is it?' },
    { key: 'ONE', still: 'a', title: 'Products that lose', moves: [{ focus: 'row', word: 'that' }, { focus: 'pill', word: 'lose' }, { click: 'pill', then: 'b', word: 'why' }] },
    { key: 'CTA', type: 'end', lines: [{ text: 'Revenue Execution', style: 'lockup' }, { text: 'revenue.opsgs.com', style: 'url' }] },
  ],
};

test('Material easings start at 0, end at 1 and stay monotonic', () => {
  Object.keys(C.EASE).forEach((k) => {
    const f = C.EASE[k];
    assert.strictEqual(f(0), 0, k);
    assert.strictEqual(f(1), 1, k);
    let last = 0;
    for (let x = 0.05; x < 1; x += 0.05) { const y = f(x); assert.ok(y >= last - 1e-9, k + ' at ' + x); last = y; }
  });
  assert.ok(C.EASE.decel(0.3) > 0.7, 'decelerate is mostly done early');
});

test('framing never zooms past the capture\'s pixels or shows canvas once zoomed in', () => {
  ['16:9', '1:1', '9:16'].forEach((aspect) => {
    const L = C.layout(aspect, { w: 1920, h: 982 }, 2);
    const cam = C.frameFor([1556, 768, 1654, 800], L);
    assert.ok(cam.s * L.k <= 2 + 1e-9, aspect + ': at most 2 screen px per still px');
    assert.ok(cam.s <= L.maxZoom + 1e-9);
    // Zoomed past the window's height: the visible scene stays inside the window.
    const top = cam.cy - L.anchor.y / cam.s, bottom = cam.cy + (L.H - L.anchor.y) / cam.s;
    if (L.win.h * cam.s >= L.H) assert.ok(top >= L.win.y - 1e-6 && bottom <= L.win.y + L.win.h + 1e-6, aspect + ': no canvas above or below');
    const left = cam.cx - L.anchor.x / cam.s, right = cam.cx + (L.W - L.anchor.x) / cam.s;
    if (L.win.w * cam.s >= L.W) assert.ok(left >= L.win.x - 1e-6 && right <= L.win.x + L.win.w + 1e-6, aspect + ': no canvas at the sides');
  });
  const L = C.layout('16:9', { w: 1920, h: 982 }, 2);
  const wide = C.wideCamera(L);
  assert.strictEqual(wide.s, 1);
  const c = C.toScreen([L.win.x + L.win.w / 2, L.win.y + L.win.h / 2], wide, L);
  assert.ok(Math.abs(c[0] - L.W / 2) < 1e-6 && Math.abs(c[1] - L.H / 2) < 1e-6, 'the wide shot centres the window');
});

test('the voice paces the film: speech-to-speech gaps, first word under a second', () => {
  const P = C.planComposition(TL, CAP, AUDIO, WORDS, '16:9');
  const [h, o, c] = P.audio;
  assert.ok(h.atMs + 250 < 1000, 'first word under 1 s');
  // ONE's speech starts 450 ms after HOOK's speech ends, whatever the clips' padding.
  assert.strictEqual(Math.round(o.atMs + 300 - (h.atMs + 1400)), 450);
  assert.strictEqual(Math.round(c.atMs + 200 - (o.atMs + 4700)), 450);
  assert.strictEqual(P.duration, Math.round(c.atMs + 3800 + 1500));
  assert.deepStrictEqual(P.beats.map((b) => b.key), ['HOOK', 'ONE', 'CTA']);
});

test('moves land on their spoken words, and a missing cue word fails loudly', () => {
  const P = C.planComposition(TL, CAP, AUDIO, WORDS, '16:9');
  const one = P.audio[1].atMs;
  const toPill = P.ring.find((s) => s.to.a === 1 && s.to.rect[0] === 1556);
  assert.ok(toPill && Math.abs(toPill.t0 - (one + 2000 - 200 + 1)) <= 1, 'the ring reaches for the pill on "lose"');
  assert.deepStrictEqual(P.presses, [Math.round(one + 4200 - 200)]);
  assert.ok(P.still.some((s) => s.key === 'b' && s.t === P.presses[0] + 90), 'the click brings the next state');
  const bad = JSON.parse(JSON.stringify(TL));
  bad.shots[1].moves[0].word = 'nowhere';
  assert.throws(() => C.planComposition(bad, CAP, AUDIO, WORDS, '16:9'), /cue word "nowhere"/);
  bad.shots[1].moves[0] = { focus: 'ghost' };
  assert.throws(() => C.planComposition(bad, CAP, AUDIO, WORDS, '16:9'), /no subject ghost/);
});

test('the cursor is placed before it shows, and is gone before the end card', () => {
  const P = C.planComposition(TL, CAP, AUDIO, WORDS, '1:1');
  const L = P.layout;
  for (let t = 0; t <= P.duration; t += 10) {
    const a = C.sample(P.cursorAlpha, t, 0, C.MIX.num);
    if (a <= 0) continue;
    const p = C.sample(P.cursor, t, P.cursor0, C.MIX.arc);
    assert.ok(p[0] > L.win.x && p[1] > L.win.y, 'drawn inside the window at ' + t + ' ms, not at the origin');
    assert.ok(t < P.end.t0, 'no pointer on the end card');
  }
  const r = C.sample(P.ring, P.end.t0, P.ring0, C.MIX.ring);
  assert.ok(r.a < 0.01, 'the ring has left before the end card');
});

test('overlayTexts lists every word the stage may draw', () => {
  assert.deepStrictEqual(C.overlayTexts(TL), ['Where is it?', 'Products that lose', 'Revenue Execution', 'revenue.opsgs.com']);
});
