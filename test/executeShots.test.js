'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildStoryboard, ShotError, stallsToShots, parseStallError, ctaLines } = require('../runner/executeShots.js');
const { normalizeDemo } = require('../shared/demoSchema.js');

/**
 * A fake `rec` that records every call. `run` answers the readiness poll
 * with ready=true; per-method behavior overridable.
 */
function makeRec(overrides) {
  const calls = [];
  const rec = {};
  const names = ['go', 'say', 'atVo', 'type', 'click', 'frame', 'spot', 'spotOut', 'crawlThrough',
    'hold', 'settle', 'motion', 'caption', 'cta', 'resetCamera', 'waitForVo'];
  names.forEach(n => {
    rec[n] = async (...args) => {
      calls.push([n, ...args]);
      if (overrides && overrides[n]) return overrides[n](...args);
    };
  });
  rec.run = async (expr) => {
    calls.push(['run', expr]);
    if (overrides && overrides.run) return overrides.run(expr);
    return { result: { value: true } }; // readiness poll satisfied instantly
  };
  rec.stepsFor = ms => Math.max(4, Math.round((ms / 1000) * 60));
  rec.elapsedMs = () => calls.length * 100;
  return { rec, calls };
}

function demoWith(shots, extra) {
  const raw = Object.assign({
    target: { kind: 'html', htmlFile: './page.html' },
    narration: [{ key: '__HOOK__', text: 'hi there, and welcome' }],
    shots,
  }, extra);
  const { demo, errors } = normalizeDemo(raw);
  assert.deepStrictEqual(errors, []);
  return demo;
}

test('prologue: go, readiness poll, then shots; no camera injection when staged', async () => {
  const demo = demoWith([{ id: 's1', action: 'hold', ms: 500 }]);
  const { rec, calls } = makeRec();
  await buildStoryboard(demo, { targetUrl: 'file:///x.html', injectCameraJs: null })(rec);
  assert.deepStrictEqual(calls[0], ['go', 'file:///x.html']);
  assert.strictEqual(calls[1][0], 'run'); // readiness
  assert.ok(calls[1][1].includes('readyState'));
  assert.ok(calls[2][1].includes('backgroundColor')); // canvas matched to the page
  assert.deepStrictEqual(calls[3], ['hold', 500]);
});

test('camera client is injected for live URLs, after readiness', async () => {
  const demo = demoWith([{ id: 's1', action: 'hold', ms: 500 }], { target: { kind: 'url', url: 'https://x' } });
  const { rec, calls } = makeRec();
  await buildStoryboard(demo, { targetUrl: 'https://x', injectCameraJs: 'CAMERA_JS' })(rec);
  const runCalls = calls.filter(c => c[0] === 'run').map(c => c[1]);
  assert.ok(runCalls[0].includes('readyState'));
  assert.strictEqual(runCalls[1], 'CAMERA_JS'); // camera before the canvas fix
  assert.ok(runCalls[2].includes('backgroundColor'));
});

test('readySelector is folded into the readiness poll', async () => {
  const demo = demoWith([{ id: 's1', action: 'hold', ms: 100 }],
    { target: { kind: 'url', url: 'https://x', readySelector: '.app-root' } });
  const { rec, calls } = makeRec();
  await buildStoryboard(demo, { targetUrl: 'https://x', injectCameraJs: null })(rec);
  assert.ok(calls[1][1].includes('.app-root'));
});

test('action mapping: say, spot, waitForVo, spotOut', async () => {
  const demo = demoWith([
    { id: 's1', action: 'say', caption: 'The page', voKey: '__HOOK__' },
    { id: 's2', action: 'spot', subject: { selector: '.kpi', nth: 1 }, ms: 300 },
    { id: 's3', action: 'waitForVo' },
    { id: 's4', action: 'spotOut' },
  ]);
  const { rec, calls } = makeRec();
  await buildStoryboard(demo, { targetUrl: 'u', injectCameraJs: null })(rec);
  const named = calls.filter(c => c[0] !== 'run');
  assert.deepStrictEqual(named[1], ['say', 'The page', 300, '__HOOK__']);
  // the comma-void suffix keeps CDP's returnByValue from serializing the
  // element (React fiber graphs overflow it) — regression from the app-tour demo
  assert.deepStrictEqual(named[2], ['spot', '(document.querySelectorAll(".kpi")[1]), void 0', 300]);
  assert.deepStrictEqual(named[3], ['waitForVo']);
  assert.deepStrictEqual(named[4], ['spotOut', 280]);
});

test('frame returning crawl triggers crawlThrough; crawlIfTall:false suppresses it', async () => {
  const shots = [
    { id: 's1', action: 'frame', subject: { selector: '.tall' }, ms: 600 },
    { id: 's2', action: 'frame', subject: { selector: '.tall2' }, ms: 600, crawlIfTall: false },
  ];
  const { rec, calls } = makeRec({ frame: () => 'crawl' });
  await buildStoryboard(demoWith(shots), { targetUrl: 'u', injectCameraJs: null })(rec);
  const crawls = calls.filter(c => c[0] === 'crawlThrough');
  assert.strictEqual(crawls.length, 1);
  assert.deepStrictEqual(crawls[0], ['crawlThrough', 1800]);
});

test('wide frames never auto-crawl unless crawlIfTall is explicitly true', async () => {
  // regression: a wide opening shot auto-crawled and pushed the first voice
  // line 5.4s into the app-tour demo
  const shots = [
    { id: 's1', action: 'frame', subject: { selector: '.app' }, mode: 'wide', ms: 600 },
    { id: 's2', action: 'frame', subject: { selector: '.app' }, mode: 'wide', ms: 600, crawlIfTall: true },
  ];
  const { rec, calls } = makeRec({ frame: () => 'crawl' });
  await buildStoryboard(demoWith(shots), { targetUrl: 'u', injectCameraJs: null })(rec);
  assert.strictEqual(calls.filter(c => c[0] === 'crawlThrough').length, 1);
});

test('click settles by default; settleMs 0 skips the settle', async () => {
  const shots = [
    { id: 's1', action: 'click', subject: { selector: '#b' } },
    { id: 's2', action: 'click', subject: { selector: '#c' }, settleMs: 0 },
  ];
  const { rec, calls } = makeRec();
  await buildStoryboard(demoWith(shots), { targetUrl: 'u', injectCameraJs: null })(rec);
  const settles = calls.filter(c => c[0] === 'settle');
  assert.strictEqual(settles.length, 1);
  assert.deepStrictEqual(settles[0], ['settle', 500]);
});

test('disabled shots are skipped and produce no events', async () => {
  const demo = demoWith([
    { id: 's1', action: 'hold', ms: 100 },
    { id: 's2', action: 'hold', ms: 100, disabled: true },
  ]);
  const events = [];
  const { rec, calls } = makeRec();
  await buildStoryboard(demo, { targetUrl: 'u', injectCameraJs: null, emit: e => events.push(e) })(rec);
  assert.strictEqual(calls.filter(c => c[0] === 'hold').length, 1);
  assert.deepStrictEqual(events.filter(e => e.type === 'shot').map(e => e.id), ['s1']);
});

test('cta runs the closing pattern: cap removal, mount at 0, say, fade, waitForVo, hold', async () => {
  const demo = demoWith([{ id: 's1', action: 'cta', lines: [{ text: 'Punch' }, { text: 'sub' }], voKey: '__HOOK__' }]);
  const { rec, calls } = makeRec();
  await buildStoryboard(demo, { targetUrl: 'u', injectCameraJs: null })(rec);
  const seq = calls.map(c => c[0]);
  const runRemove = calls.filter(c => c[0] === 'run' && String(c[1]).includes('__demoCap'));
  assert.strictEqual(runRemove.length, 1);
  assert.ok(seq.indexOf('cta') < seq.indexOf('say'));
  assert.ok(seq.indexOf('say') < seq.indexOf('motion'));
  assert.ok(seq.indexOf('motion') < seq.indexOf('waitForVo'));
  assert.deepStrictEqual(calls[calls.length - 1], ['hold', 1200]);
});

test('ctaLines applies default styling and accepts bare strings', () => {
  const lines = ctaLines(['Big', { text: 'Small' }]);
  assert.strictEqual(lines[0].text, 'Big');
  assert.ok(lines[0].css.includes('700'));
  assert.ok(lines[1].css.includes('margin-top'));
});

test('a failing shot throws ShotError carrying id, index and action', async () => {
  const demo = demoWith([
    { id: 's1', action: 'hold', ms: 100 },
    { id: 'sBoom', action: 'spot', subject: { selector: '.x' } },
  ]);
  const { rec } = makeRec({ spot: () => { throw new Error('no such element'); } });
  await assert.rejects(
    buildStoryboard(demo, { targetUrl: 'u', injectCameraJs: null })(rec),
    err => err instanceof ShotError && err.shotId === 'sBoom' && err.index === 1 && err.action === 'spot');
});

test('stallsToShots maps a stall to the nearest preceding shot', () => {
  const timeline = [
    { id: 's1', index: 0, startMs: 0 },
    { id: 's2', index: 1, startMs: 4000 },
    { id: 's3', index: 2, startMs: 9000 },
  ];
  const mapped = stallsToShots([{ atMs: 8500, ms: 6000 }], timeline);
  assert.deepStrictEqual(mapped, [{ atMs: 8500, ms: 6000, nearShotId: 's2' }]);
});

test('parseStallError reads the recorder message format', () => {
  const msg = 'the picture sits still AND silent for longer than 5s:\n' +
    '    12.3s  \u2014 6.7s still\n    40.0s  \u2014 5.1s still';
  assert.deepStrictEqual(parseStallError(msg), [
    { atMs: 12300, ms: 6700 },
    { atMs: 40000, ms: 5100 },
  ]);
});
