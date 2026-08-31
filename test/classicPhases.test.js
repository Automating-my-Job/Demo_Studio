'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parsePhaseLine } = require('../runner/classic.js');

test('parses the example build.js phase lines', () => {
  // regression: exact lines printed by the engine's example build script
  assert.deepStrictEqual(
    parsePhaseLine('1/4  rendering the real dashboard via the project\'s own Node harness…'),
    { current: 1, total: 4, label: 'rendering the real dashboard via the project\'s own Node harness…' });
  assert.deepStrictEqual(
    parsePhaseLine('4/4  delivering a LinkedIn-safe encode…'),
    { current: 4, total: 4, label: 'delivering a LinkedIn-safe encode…' });
});

test('ignores non-phase lines', () => {
  assert.strictEqual(parsePhaseLine('   /Users/someone/proj/demo-out/demo.mp4  (14.8s, 3.1 MB)'), null);
  assert.strictEqual(parsePhaseLine('done.'), null);
  assert.strictEqual(parsePhaseLine(''), null);
});
