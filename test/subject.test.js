'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { compileSubject, describeSubject } = require('../runner/subject.js');

test('bare selector compiles to querySelector', () => {
  assert.strictEqual(compileSubject({ selector: '.kpi' }), 'document.querySelector(".kpi")');
});

test('nth 0 stays querySelector; nth > 0 indexes querySelectorAll', () => {
  assert.strictEqual(compileSubject({ selector: '.kpi', nth: 0 }), 'document.querySelector(".kpi")');
  assert.strictEqual(compileSubject({ selector: '.kpi', nth: 2 }), 'document.querySelectorAll(".kpi")[2]');
});

test('textContains filters, honoring nth', () => {
  assert.strictEqual(
    compileSubject({ selector: '.card', textContains: 'Risks' }),
    'Array.from(document.querySelectorAll(".card")).filter(function(e){return e.textContent.indexOf("Risks")!==-1;})[0]');
  assert.strictEqual(
    compileSubject({ selector: '.card', textContains: 'Risks', nth: 1 }),
    'Array.from(document.querySelectorAll(".card")).filter(function(e){return e.textContent.indexOf("Risks")!==-1;})[1]');
});

test('quotes in selectors and text are escaped via JSON.stringify', () => {
  const expr = compileSubject({ selector: '[data-x="a"]', textContains: 'say "hi"' });
  assert.ok(expr.includes('"[data-x=\\"a\\"]"'));
  assert.ok(expr.includes('"say \\"hi\\""'));
});

test('expr passes through verbatim and wins over selector', () => {
  assert.strictEqual(compileSubject({ expr: 'window.__cell', selector: '.x' }), 'window.__cell');
});

test('empty spec throws', () => {
  assert.throws(() => compileSubject({}), /selector or expr/);
  assert.throws(() => compileSubject(null), /missing/);
});

test('describeSubject renders compact labels', () => {
  assert.strictEqual(describeSubject({ selector: '.kpi', nth: 2 }), '.kpi [2]');
  assert.strictEqual(describeSubject({ selector: '.card', textContains: 'X' }), '.card ~"X"');
});
