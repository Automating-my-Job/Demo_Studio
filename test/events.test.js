'use strict';
const test = require('node:test');
const assert = require('node:assert');
const events = require('../shared/events.js');

test('phase enforces known phases and statuses', () => {
  assert.deepStrictEqual(events.phase('narrate', 'start'), { type: 'phase', phase: 'narrate', status: 'start' });
  assert.throws(() => events.phase('nope', 'start'), /unknown phase/);
  assert.throws(() => events.phase('narrate', 'maybe'), /unknown status/);
});

test('log normalizes stream names', () => {
  assert.strictEqual(events.log('err', 'x').stream, 'err');
  assert.strictEqual(events.log('anything-else', 'x').stream, 'out');
});

test('result merges fields over defaults', () => {
  const r = events.result({ outPath: '/a.mp4', durationSec: 12 });
  assert.strictEqual(r.type, 'result');
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.stalls, []);
  assert.strictEqual(r.outPath, '/a.mp4');
});

test('error carries extras', () => {
  const e = events.error('record', 'boom', { shotId: 's3' });
  assert.strictEqual(e.type, 'error');
  assert.strictEqual(e.shotId, 's3');
});

test('parseLine round-trips events and ignores plain log lines', () => {
  const ev = events.progress('narrate', 2, 7, 'clip 2 of 7');
  assert.deepStrictEqual(events.parseLine(JSON.stringify(ev)), ev);
  assert.strictEqual(events.parseLine('narrating 2/7...'), null);
  assert.strictEqual(events.parseLine('{broken json'), null);
});
