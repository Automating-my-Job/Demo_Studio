'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseSilence, analyze } = require('../runner/audioQa.js');

const FFMPEG_STDERR = [
  '[Parsed_silencedetect_0 @ 0x1] silence_start: 0',
  '[Parsed_silencedetect_0 @ 0x1] silence_end: 5.389937 | silence_duration: 5.389937',
  '[Parsed_silencedetect_0 @ 0x1] silence_start: 12.24775',
  '[Parsed_silencedetect_0 @ 0x1] silence_end: 13.1 | silence_duration: 0.85',
  'frame= 3595 fps=0.0 q=-0.0 Lsize=N/A',
].join('\n');

test('parseSilence reads ffmpeg silencedetect output', () => {
  const s = parseSilence(FFMPEG_STDERR);
  assert.deepStrictEqual(s, [
    { startMs: 0, endMs: 5390, durMs: 5390 },
    { startMs: 12248, endMs: 13100, durMs: 850 },
  ]);
});

test('a late first voice is flagged — the 5.4s bug as a regression', () => {
  const r = analyze(parseSilence(FFMPEG_STDERR), 60000);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.firstVoiceMs, 5390);
  assert.ok(r.issues[0].includes('5.4s'));
});

test('a cold open with short beats passes', () => {
  const r = analyze([
    { startMs: 7490, endMs: 8631, durMs: 1141 },
    { startMs: 30000, endMs: 33000, durMs: 3000 },
  ], 60000);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.firstVoiceMs, 0);
});

test('interior dead air and a limp silent ending are flagged', () => {
  const r = analyze([
    { startMs: 20000, endMs: 26500, durMs: 6500 },
    { startMs: 52000, endMs: null, durMs: null },
  ], 60000);
  assert.strictEqual(r.ok, false);
  assert.ok(r.issues.some(i => i.startsWith('dead air') && i.includes('6.5s')));
  assert.ok(r.issues.some(i => i.includes('ending') && i.includes('8.0s')));
});

test('an unclosed silence at 0 means a silent video', () => {
  const r = analyze([{ startMs: 0, endMs: null, durMs: null }], 30000);
  assert.strictEqual(r.firstVoiceMs, 30000);
  assert.strictEqual(r.ok, false);
});
