'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildReviewRequest, REVIEW_SCHEMA } = require('../runner/review.js');
const { normalizeDemo } = require('../shared/demoSchema.js');

function fakeFrames(ids) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-review-'));
  return ids.map((id, i) => {
    const file = path.join(dir, id + '.jpg');
    fs.writeFileSync(file, Buffer.from('jpegbytes-' + id));
    return { id, atMs: i * 2000 + 400, file };
  });
}

test('the review request interleaves labeled shot text with frame images', () => {
  const { demo } = normalizeDemo({
    target: { kind: 'url', url: 'https://x' },
    narration: [{ key: '__HOOK__', text: 'The hook line.' }],
    shots: [
      { id: 's1', action: 'frame', subject: { selector: '.app' }, mode: 'wide' },
      { id: 's2', action: 'say', caption: 'The page', voKey: '__HOOK__' },
    ],
  });
  const req = buildReviewRequest(demo, fakeFrames(['s1', 's2']));
  const parts = req.contents[0].parts;
  assert.ok(parts[0].text.includes('Spotlight, never crop'));
  assert.ok(parts[1].text.includes('REVIEWING a finished cut'));
  assert.ok(parts[1].text.includes('__HOOK__: The hook line.'));
  // each frame: a label part then an image part, in shot order
  assert.ok(parts[2].text.includes('Shot s1 (frame'));
  assert.strictEqual(parts[3].inlineData.mimeType, 'image/jpeg');
  assert.strictEqual(Buffer.from(parts[3].inlineData.data, 'base64').toString(), 'jpegbytes-s1');
  assert.ok(parts[4].text.includes('Shot s2 (say, caption "The page")'));
  assert.strictEqual(req.generationConfig.responseSchema, REVIEW_SCHEMA);
});

test('critique schema requires shotId, severity and problem', () => {
  const item = REVIEW_SCHEMA.properties.critiques.items;
  assert.deepStrictEqual(item.required, ['shotId', 'severity', 'problem']);
  assert.deepStrictEqual(item.properties.severity.enum, ['error', 'warning', 'note']);
});
