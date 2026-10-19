'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { quotedLabels, spokenText, closest, formatReport, wordDiff } = require('../vendor/demo-suite/lib/preflight.js');

test('quotedLabels reads curly and straight double quotes, once each, in order', () => {
  assert.deepStrictEqual(
    quotedLabels('Open “Revenue Execution Viewer”, then "Manage Assignments" and “Manage Assignments” again.'),
    ['Revenue Execution Viewer', 'Manage Assignments']);
  assert.deepStrictEqual(quotedLabels("It isn't quoted, so there's nothing."), [], 'apostrophes are not quotes');
  assert.deepStrictEqual(quotedLabels(undefined), []);
});

test('spokenText drops the quote marks and keeps every word', () => {
  assert.strictEqual(spokenText('Type “Permission Sets” in  "Quick Find".'), 'Type Permission Sets in Quick Find.');
});

test('closest ranks a case-only difference first, then containing phrases, then near spellings', () => {
  const screen = ['Permission Sets', 'Permission Set Groups', 'Profiles', 'manage assignments', 'Manage Assignments for Users', 'Users'];
  assert.deepStrictEqual(closest('Manage Assignments', screen, 2), ['manage assignments', 'Manage Assignments for Users']);
  assert.deepStrictEqual(closest('Permission Set', screen, 2), ['Permission Sets', 'Permission Set Groups']);
  assert.deepStrictEqual(closest('Admin / Setup', screen), [], 'nothing close is better than a wrong guess');
});

test('formatReport prints a script-vs-screen diff per failing beat', () => {
  const report = formatReport([
    { key: 'B1', say: 'Open “Admin / Setup”.', misses: [] },
    { key: 'B3', say: 'Open “Revenue Execution Viewer”, then “Manage Assignment”.',
      misses: [{ label: 'Manage Assignment', status: 'missing', near: ['Manage Assignments'] }] },
  ], 5);
  assert.match(report, /^Wording preflight FAILED: 1 of 5 label\(s\) not on screen as scripted/);
  assert.match(report, /B3 {2}"Open Revenue Execution Viewer, then Manage Assignment\."/);
  assert.match(report, /- script: "Manage Assignment" {3}screen: missing {3}closest on screen: "Manage Assignments"/);
  assert.ok(!/B1/.test(report), 'passing beats stay out of the diff');
  assert.strictEqual(formatReport([{ key: 'B1', misses: [] }], 3), 'Wording preflight passed: 3 label(s) on screen as scripted.');
});

test('wordDiff passes what Whisper heard when only spacing, case or punctuation differ', () => {
  const r = wordDiff('In Setup, type “Permission Sets” in “Quick Find”, and open it.', 'In setup, type permission sets in QuickFind and open it.');
  assert.deepStrictEqual(r, { ok: true, diffs: [] });
  assert.ok(wordDiff('type “Admin / Setup”', 'type admin slash setup').ok, 'a slash is spoken as "slash"');
});

test('wordDiff lists each stretch that differs, side by side', () => {
  const r = wordDiff('Pick “R”, open “Revenue Execution Viewer”.', 'Pick our open Revenue Execution viewer');
  assert.deepStrictEqual(r.diffs, [{ script: 'r', heard: 'our' }]);
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(wordDiff('then Manage Assignments to see', 'then manage assignment to see').diffs, [{ script: 'assignments', heard: 'assignment' }]);
});
