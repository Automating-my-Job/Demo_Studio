'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { waitForReady } = require('../runner/readiness.js');

function fakeRec(values) {
  let i = 0;
  const exprs = [];
  return {
    exprs,
    rec: {
      run: async (expr) => {
        exprs.push(expr);
        const v = i < values.length ? values[i++] : values[values.length - 1];
        return { result: { value: v } };
      },
    },
  };
}

test('resolves once the page reports ready', async () => {
  const { rec } = fakeRec([false, false, true]);
  await waitForReady(rec, { pollMs: 1, sleepFn: () => Promise.resolve() });
});

test('readySelector is included in the polled expression', async () => {
  const { rec, exprs } = fakeRec([true]);
  await waitForReady(rec, { readySelector: '.app-page' });
  assert.ok(exprs[0].includes('document.readyState'));
  assert.ok(exprs[0].includes('.app-page'));
});

test('times out with a helpful message', async () => {
  const { rec } = fakeRec([false]);
  await assert.rejects(
    waitForReady(rec, { readySelector: '.app', timeoutMs: 5, pollMs: 1, sleepFn: () => Promise.resolve() }),
    /did not become ready.*\.app/s);
});
