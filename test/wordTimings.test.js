'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { wordTime, normalizeWord } = require('../vendor/demo-suite/lib/wordTimings.js');

const words = {
  HERO: [
    { w: 'The', s: 0.1, e: 0.2 }, { w: "what's", s: 3.0, e: 3.2 }, { w: 'already', s: 3.2, e: 3.5 },
    { w: 'late,', s: 3.5, e: 3.9 }, { w: "what's", s: 4.2, e: 4.4 }, { w: 'in', s: 4.4, e: 4.5 },
    { w: 'play,', s: 4.5, e: 4.9 }, { w: 'lined', s: 7.0, e: 7.2 }, { w: 'up', s: 7.2, e: 7.3 },
  ],
  GANTT: [{ w: 'OnTrack', s: 4.1, e: 4.5 }, { w: "aren't", s: 5.0, e: 5.2 }],
};

test('normalizeWord drops case and punctuation', () => {
  assert.strictEqual(normalizeWord('On-track,'), 'ontrack');
  assert.strictEqual(normalizeWord('aren’t'), 'arent');
});

test('wordTime finds a word regardless of trailing punctuation', () => {
  assert.strictEqual(wordTime(words, 'HERO', 'late'), 3.5);
  assert.strictEqual(wordTime(words, 'HERO', 'play'), 4.5);
});

test('wordTime matches multi-word needles and later occurrences', () => {
  assert.strictEqual(wordTime(words, 'HERO', 'lined up'), 7.0);
  assert.strictEqual(wordTime(words, 'HERO', "what's", 2), 4.2);
  assert.strictEqual(wordTime(words, 'GANTT', 'on-track'), 4.1, 'ASR may join hyphenated words');
  assert.strictEqual(wordTime(words, 'GANTT', 'aren’t'), 5.0);
});

test('wordTime returns null when the word was not heard', () => {
  assert.strictEqual(wordTime(words, 'HERO', 'quarter'), null);
  assert.strictEqual(wordTime(words, 'MISSING', 'late'), null);
});
