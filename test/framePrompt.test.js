'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildFramingRequest, parseFraming, lintStatic, RESPONSE_SCHEMA } = require('../runner/frame.js');
const { normalizeDemo } = require('../shared/demoSchema.js');
const outline = require('./fixtures/outline-sample.json');

function baseDemo() {
  const { demo } = normalizeDemo({
    target: { kind: 'url', url: 'https://x' },
    instructions: 'Sell the risk KPIs to an executive audience in 60 seconds.',
    narration: [],
    shots: [],
  });
  return demo;
}

test('the request carries rules, instructions, outline, screenshot and schema', () => {
  const req = buildFramingRequest(baseDemo(), outline, 'B64JPEG');
  const texts = req.contents[0].parts.filter(p => p.text).map(p => p.text).join('\n');
  assert.ok(texts.includes('Spotlight, never crop'));
  assert.ok(texts.includes('Sell the risk KPIs'));
  assert.ok(texts.includes('div.kpi'));
  const img = req.contents[0].parts.filter(p => p.inlineData)[0];
  assert.strictEqual(img.inlineData.data, 'B64JPEG');
  assert.strictEqual(req.generationConfig.responseSchema, RESPONSE_SCHEMA);
  assert.strictEqual(req.generationConfig.responseMimeType, 'application/json');
});

test('rejection feedback is appended on retry', () => {
  const req = buildFramingRequest(baseDemo(), outline, null, ['shots[0]: bad thing']);
  const last = req.contents[0].parts[req.contents[0].parts.length - 1].text;
  assert.ok(last.includes('previous attempt was rejected'));
  assert.ok(last.includes('shots[0]: bad thing'));
});

test('parseFraming accepts a good response (flat subjects normalized)', () => {
  const good = JSON.stringify({
    narration: [{ key: '__HOOK__', text: 'One page, and everything on it earns its place.' }],
    shots: [
      { action: 'frame', selector: 'div.demo-page', mode: 'wide', ms: 600 },
      { action: 'say', caption: 'The page', voKey: '__HOOK__' },
      { action: 'spot', selector: 'div.kpi', nth: 1 },
      { action: 'waitForVo' },
      { action: 'cta', lines: [{ text: 'Done.' }], voKey: '__HOOK__' },
    ],
  });
  const r = parseFraming(good, baseDemo());
  assert.deepStrictEqual(r.errors, []);
  assert.deepStrictEqual(r.shots[2].subject, { selector: 'div.kpi', nth: 1 });
});

test('parseFraming rejects malformed JSON and schema violations', () => {
  assert.ok(parseFraming('not json at all', baseDemo()).errors.length);
  const bad = JSON.stringify({ narration: [], shots: [{ action: 'teleport' }] });
  const r = parseFraming(bad, baseDemo());
  assert.ok(r.errors.some(e => e.includes('teleport')));
});

test('lintStatic flags selectors missing from the outline', () => {
  const { demo } = normalizeDemo({
    target: { kind: 'url', url: 'https://x' },
    narration: [],
    shots: [
      { id: 's1', action: 'spot', subject: { selector: 'div.kpi' } },
      { id: 's2', action: 'spot', subject: { selector: '.invented-thing' } },
    ],
  });
  const lint = lintStatic(demo.shots, outline);
  assert.deepStrictEqual(lint.map(l => l.shotId), ['s2']);
});
