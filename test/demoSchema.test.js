'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { normalizeDemo, narrationToObject, guardOutDir } = require('../shared/demoSchema.js');

function validDemo() {
  return JSON.parse(JSON.stringify(require('./fixtures/static-page/demo.json')));
}

test('a valid demo normalizes with no errors', () => {
  const { errors, warnings, demo } = normalizeDemo(validDemo());
  assert.deepStrictEqual(errors, []);
  assert.deepStrictEqual(warnings, []);
  assert.strictEqual(demo.shots.length, 7);
});

test('null entries in shots and narration are skipped, not errors', () => {
  const raw = validDemo();
  raw.shots.splice(2, 0, null);
  raw.narration.push(null);
  const { errors, demo } = normalizeDemo(raw);
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(demo.shots.length, 7);
  assert.strictEqual(demo.narration.length, 2);
});

test('a disabled shot is kept but never hard-validated', () => {
  const raw = validDemo();
  raw.shots.push({ id: 'sX', action: 'frame', disabled: true }); // no subject: invalid if enabled
  const { errors, demo } = normalizeDemo(raw);
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(demo.shots[demo.shots.length - 1].disabled, true);
});

test('unknown keys survive normalization (round-trip safety)', () => {
  const raw = validDemo();
  raw.myCustomNote = 'keep me';
  raw.shots[0].experimentalFlag = 42;
  raw.record.customEncoder = 'x265';
  const { demo } = normalizeDemo(raw);
  assert.strictEqual(demo.myCustomNote, 'keep me');
  assert.strictEqual(demo.shots[0].experimentalFlag, 42);
  assert.strictEqual(demo.record.customEncoder, 'x265');
});

test('GitHub share settings normalize with defaults and fail early when invalid', () => {
  const raw = validDemo();
  raw.githubShare = {
    repository: 'https://github.com/example/demo',
    title: 'Example — Demo',
    description: 'Demo video for Example.',
    summary: 'A short summary.',
    features: ['One feature.'],
  };
  const valid = normalizeDemo(raw);
  assert.deepStrictEqual(valid.errors, []);
  assert.strictEqual(valid.demo.githubShare.branch, 'main');
  assert.strictEqual(valid.demo.githubShare.videoFileName, 'demo.mp4');

  raw.githubShare.repository = 'https://example.com/not-github';
  const invalid = normalizeDemo(raw);
  assert.ok(invalid.errors.some(error => error.includes('github.com')));
});

test('flat Gemini subject shape is normalized into subject', () => {
  const raw = validDemo();
  raw.shots.push({ id: 'sF', action: 'spot', selector: '.kpi', nth: 2 });
  const { errors, demo } = normalizeDemo(raw);
  assert.deepStrictEqual(errors, []);
  const s = demo.shots[demo.shots.length - 1];
  assert.deepStrictEqual(s.subject, { selector: '.kpi', nth: 2 });
  assert.strictEqual(s.selector, undefined);
});

test('"type" keeps its own top-level selector — it is not a subject action', () => {
  // regression: normalizeSubject_ used to hijack ANY top-level selector into
  // shot.subject regardless of the action, so a "type" shot (whose selector
  // names the input to type into) lost its required field and failed
  // validation with "missing required field selector".
  const raw = validDemo();
  raw.shots.push({ id: 'sT', action: 'type', selector: '#profile-address', text: 'hi' });
  const { errors, demo } = normalizeDemo(raw);
  assert.deepStrictEqual(errors, []);
  const s = demo.shots[demo.shots.length - 1];
  assert.strictEqual(s.selector, '#profile-address');
  assert.strictEqual(s.subject, undefined);
});

test('missing subject on a subject action is an error', () => {
  const raw = validDemo();
  raw.shots.push({ id: 'sB', action: 'frame' });
  const { errors } = normalizeDemo(raw);
  assert.ok(errors.some(e => e.includes('sB') && e.includes('subject')));
});

test('a say with an unknown voKey warns about a silent beat', () => {
  const raw = validDemo();
  raw.shots[2].voKey = '__NOPE__';
  const { errors, warnings } = normalizeDemo(raw);
  assert.deepStrictEqual(errors, []);
  assert.ok(warnings.some(w => w.includes('__NOPE__')));
});

test('a final say with no waitForVo afterwards warns', () => {
  const raw = validDemo();
  raw.shots = raw.shots.slice(0, 3); // ends on the say
  const { warnings } = normalizeDemo(raw);
  assert.ok(warnings.some(w => w.includes('waitForVo')));
});

test('defaults fill without clobbering explicit values', () => {
  const raw = validDemo();
  delete raw.record;
  const { demo } = normalizeDemo(raw);
  assert.strictEqual(demo.record.fps, 60);
  const raw2 = validDemo();
  const { demo: d2 } = normalizeDemo(raw2);
  assert.strictEqual(d2.record.fps, 30);
});

test('narrationToObject preserves order and skips disabled', () => {
  const obj = narrationToObject([
    { key: '__B__', text: 'b' },
    { key: '__SKIP__', text: 'x', disabled: true },
    { key: '__A__', text: 'a', voice: 'Samantha' },
  ]);
  assert.deepStrictEqual(Object.keys(obj), ['__B__', '__A__']);
  assert.strictEqual(obj.__A__.voice, 'Samantha');
});

test('guardOutDir accepts demo-out paths and app data, refuses everything else', () => {
  const userData = '/Users/someone/Library/Application Support/demo-studio';
  assert.ok(guardOutDir('/Users/someone/proj/demo-out/vo', userData));
  assert.ok(guardOutDir(path.join(userData, 'scratch', 'samples', 'abc'), userData));
  assert.throws(() => guardOutDir('/Users/someone/Documents', userData), /refusing/);
  assert.throws(() => guardOutDir('/Users/someone', userData), /refusing/);
  assert.throws(() => guardOutDir('/', userData), /refusing/);
});
