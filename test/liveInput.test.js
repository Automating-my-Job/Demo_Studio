'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  createLive, keyFor, keyEventsFor, namedKey, subjectExpr, describeSubject, glideMsFor, easeInOut,
} = require('../vendor/demo-suite/lib/liveInput.js');

test('keyFor maps printable characters to real key codes, shifted where a person would shift', () => {
  assert.deepStrictEqual(keyFor('a'), { key: 'a', code: 'KeyA', keyCode: 65, shift: false });
  assert.deepStrictEqual(keyFor('S'), { key: 'S', code: 'KeyS', keyCode: 83, shift: true });
  assert.deepStrictEqual(keyFor('/'), { key: '/', code: 'Slash', keyCode: 191, shift: false });
  assert.deepStrictEqual(keyFor(' '), { key: ' ', code: 'Space', keyCode: 32, shift: false });
  assert.deepStrictEqual(keyFor('&'), { key: '&', code: 'Digit7', keyCode: 55, shift: true });
  assert.strictEqual(keyFor('é'), null, 'falls back to insertText');
});

test('keyEventsFor emits a keyDown carrying the text, then a keyUp', () => {
  const [down, up] = keyEventsFor('A');
  assert.strictEqual(down.type, 'keyDown');
  assert.strictEqual(down.text, 'A');
  assert.strictEqual(down.modifiers, 8, 'Shift');
  assert.strictEqual(up.type, 'keyUp');
  assert.strictEqual(up.text, undefined, 'keyUp types nothing');
  assert.strictEqual(namedKey('Enter').keyCode, 13);
  assert.throws(() => namedKey('Hyper'), /unknown key/);
});

test('subjectExpr compiles label, shadow-path, and expression subjects', () => {
  assert.strictEqual(subjectExpr({ text: 'Manage Assignments' }), '__findText("Manage Assignments",{})');
  assert.strictEqual(subjectExpr({ text: 'Viewer', exact: false, selector: 'a', nth: 1 }), '__findText("Viewer",{"selector":"a","exact":false,"nth":1})');
  assert.strictEqual(subjectExpr({ text: 'Admin / Setup', within: 'one-app-launcher-menu' }), '__findText("Admin / Setup",{"within":"one-app-launcher-menu"})');
  assert.strictEqual(subjectExpr({ q: 'c-app >>> .card', text: 'Acme' }), '__q("c-app >>> .card","Acme")');
  assert.strictEqual(subjectExpr({ expr: 'document.body' }), '(document.body)');
  assert.throws(() => subjectExpr({ frame: 'top' }), /needs text, q, or expr/);
  assert.strictEqual(describeSubject({ text: 'Quick Find', frame: 'top' }), '"Quick Find" in top');
});

test('the cursor glide is quick for short hops and capped for long ones; easing is symmetric', () => {
  assert.strictEqual(glideMsFor(0), 380);
  assert.strictEqual(glideMsFor(2000), 900);
  assert.ok(Math.abs(easeInOut(0.5) - 0.5) < 1e-9);
  assert.ok(easeInOut(0.1) < 0.1 && easeInOut(0.9) > 0.9, 'slow out, slow in');
});

// A fake recorder internals + frame registry: one top frame and one Setup
// iframe whose viewport starts at (250, 136) in the top frame.
function harness(o) {
  const sent = [];
  const film = [];
  const ran = [];
  const top = { key: ':1', sid: null, id: 1, frameId: 'TOP' };
  const setup = { key: 'S1:1', sid: 'S1', id: 1, frameId: 'OOP' };
  const frames = {
    list: () => [top, setup],
    children: () => [setup],
    top: () => top,
    isTop: (c) => c === top,
    ensureKit: async () => false,
    offset: async (c) => (c === top ? { x: 0, y: 0, s: 1 } : { x: 250, y: 136, s: 1 }),
    evaluate: async (c, expr) => {
      if (expr.indexOf('__labelCheck') === 0) return (o.labels && o.labels(c)) || [];
      if (expr === 'window.__covers||[]') return o.covers || [];
      if (expr.indexOf('window.__dsSubject=el') !== -1) {
        // Only the Setup iframe has the "Manage Assignments" button.
        if (c === setup && expr.indexOf('Manage Assignments') !== -1) return { l: 50, t: 564, r: 210, b: 594 };
        if (c === top && expr.indexOf('Quick Find') !== -1) return { l: 14, t: 150, r: 224, b: 182 };
        return null;
      }
      return true;
    },
  };
  const k = {
    client: { send: async (m, p) => { sent.push([m, p]); return {}; } },
    frames: frames,
    run: async (expr) => { ran.push(expr); return { result: { value: true } }; },
    motion: async (fn, steps, ms) => { for (let i = 1; i <= steps; i++) ran.push(fn(i / steps)); film.push(['motion', ms]); },
    stepsFor: (ms) => Math.max(4, Math.round(ms / 1000 * 60)),
    frame: async (ms) => film.push(['frame', ms]),
    opts: Object.assign({ cursor: true, cursorStart: [960, 700] }, o.opts || {}),
    dry: true, width: 1920, height: 1080,
  };
  return { live: createLive(k), sent, film, ran };
}

test('a click on a subject inside the Setup iframe glides the cursor and clicks at its TOP-frame center', async () => {
  const { live, sent, film, ran } = harness({});
  const hit = await live.clickOn({ text: 'Manage Assignments' });
  assert.deepStrictEqual([hit.cx, hit.cy], [380, 715], 'iframe rect (50..210, 564..594) + offset (250, 136)');
  assert.deepStrictEqual(film.map((f) => f[0]), ['motion', 'motion'], 'glide, then the press dip');
  assert.ok(ran.includes('__cursor(380,715,0.000)'), 'the glide ends on the target');
  assert.ok(ran.includes('__cursor(380,715,1.000)'), 'then dips (press) on it');
  const mouse = sent.filter(([m]) => m === 'Input.dispatchMouseEvent').map(([, p]) => p.type + '@' + p.x + ',' + p.y);
  assert.deepStrictEqual(mouse.slice(-3), ['mouseMoved@380,715', 'mousePressed@380,715', 'mouseReleased@380,715']);
  assert.deepStrictEqual(live.cursorState(), { x: 380, y: 715, shown: true });
});

test('typing sends one real keystroke pair per character and films one frame each, ~10 per second', async () => {
  const { live, sent, film } = harness({});
  await live.typeInto({ text: 'Quick Find', frame: 'top' }, 'Perm Sets');
  const keys = sent.filter(([m]) => m === 'Input.dispatchKeyEvent').map(([, p]) => p.type + ':' + p.key);
  assert.strictEqual(keys.length, 18);
  assert.deepStrictEqual(keys.slice(0, 4), ['keyDown:P', 'keyUp:P', 'keyDown:e', 'keyUp:e']);
  const typed = film.filter((f) => f[0] === 'frame');
  assert.strictEqual(typed.length, 9);
  assert.ok(typed.every((f) => f[1] === 100), '100 ms of film per character');
  const firstClick = sent.findIndex(([m, p]) => m === 'Input.dispatchMouseEvent' && p.type === 'mousePressed');
  const firstKey = sent.findIndex(([m]) => m === 'Input.dispatchKeyEvent');
  assert.ok(firstClick !== -1 && firstClick < firstKey, 'the field is clicked (focused) before typing');
});

test('a subject that is not on screen stops the action with a readable reason', async () => {
  const { live } = harness({});
  await assert.rejects(live.clickOn({ text: 'Manage Assignment', frame: 'child' }), /click\(\) subject is not on screen: "Manage Assignment" in child/);
  assert.strictEqual(await live.resolve({ text: 'Quick Find', frame: 'child' }), null, 'frame matchers narrow the search');
});

test('spotOn rings an iframe subject using top-frame coordinates', async () => {
  const { live, ran } = harness({});
  await live.spotOn({ text: 'Manage Assignments' }, 120);
  assert.strictEqual(ran.slice(-1)[0], '__spotRect(300,700,460,730,1.000)');
});

test('labelCheck takes the best status across frames, and an iframe label under the band is covered', async () => {
  const { live } = harness({
    covers: [{ l: 0, t: 0, r: 1920, b: 200 }],
    labels: (c) => (c.sid ? [
      { label: 'Manage Assignments', status: 'visible', rect: { l: 50, t: 564, r: 210, b: 594 } },
      { label: 'Show more', status: 'visible', rect: { l: 10, t: 0, r: 80, b: 30 } },
      { label: 'Setup', status: 'missing', rect: null },
    ] : [
      { label: 'Manage Assignments', status: 'hidden', rect: null },
      { label: 'Show more', status: 'missing', rect: null },
      { label: 'Setup', status: 'visible', rect: { l: 60, t: 110, r: 110, b: 130 } },
    ]),
  });
  const res = await live.labelCheck(['Manage Assignments', 'Show more', 'Setup']);
  assert.deepStrictEqual(res.map((r) => [r.label, r.status, r.frame]), [
    ['Manage Assignments', 'visible', 'child'],
    ['Show more', 'covered', 'child'],
    ['Setup', 'visible', 'top'],
  ]);
});

test('scrollTo wheels the list one filmed step at a time until the target shows, and gives up loudly', async () => {
  const sent = [];
  const film = [];
  let wheels = 0;
  const ctx = { key: 'S1:1', sid: 'S1', id: 1, frameId: 'OOP' };
  const frames = {
    list: () => [ctx], children: () => [ctx], top: () => null, isTop: () => false,
    ensureKit: async () => false,
    offset: async () => ({ x: 250, y: 136, s: 1 }),
    evaluate: async (c, expr) => {
      if (expr.indexOf('window.__dsSubject=el') === -1) return true;
      if (expr.indexOf('THE_LIST') !== -1) return { l: 26, t: 157, r: 331, b: 329 };
      if (expr.indexOf('Revenue Execution Viewer') !== -1) return wheels >= 4 ? { l: 27, t: 300, r: 330, b: 317 } : null;
      return null;
    },
  };
  const live = createLive({
    client: { send: async (m, p) => { sent.push([m, p]); if (p && p.type === 'mouseWheel') wheels++; return {}; } },
    frames, run: async () => ({}), motion: async (fn, steps, ms) => { film.push(['motion', ms]); },
    stepsFor: () => 4, frame: async (ms) => film.push(['frame', ms]),
    opts: { cursor: true, cursorStart: [960, 700] }, dry: true, width: 1920, height: 1080,
  });
  const list = { expr: 'THE_LIST', frame: 'child' };
  await live.scrollTo({ text: 'Revenue Execution Viewer', frame: 'child', selector: 'option' }, { within: list });
  const wheel = sent.filter(([m, p]) => m === 'Input.dispatchMouseEvent' && p.type === 'mouseWheel');
  assert.strictEqual(wheel.length, 4, 'stops as soon as the option is visible');
  assert.deepStrictEqual([wheel[0][1].x, wheel[0][1].y, wheel[0][1].deltaY], [429, 379, 90], 'on the list, mapped to top-frame px');
  assert.strictEqual(film.filter((f) => f[0] === 'frame').length, 5, 'one filmed frame per wheel step, plus one while the list settles');
  assert.strictEqual(film[0][0], 'motion', 'the cursor glides onto the list first');
  wheels = -1000;
  await assert.rejects(live.scrollTo({ text: 'Revenue Execution Viewer', frame: 'child' }, { within: list, maxSteps: 3 }), /never came into view/);
});
