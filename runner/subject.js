'use strict';
/**
 * subject.js — compiles a demo.json subject spec into the JS expression
 * string that recorder.js's frame/spot/click primitives evaluate in the
 * page. Structured specs keep Gemini's output away from raw code; `expr`
 * is the deliberate power-user escape hatch and passes through verbatim.
 */

/**
 * @param {{selector?: string, nth?: number, textContains?: string, expr?: string}} spec
 * @returns {string} a JS expression evaluating to an element (or undefined)
 */
function compileSubject(spec) {
  if (!spec || typeof spec !== 'object') throw new Error('subject spec missing');
  if (typeof spec.expr === 'string' && spec.expr.trim()) return spec.expr.trim();
  if (typeof spec.selector !== 'string' || !spec.selector.trim()) {
    throw new Error('subject needs a selector or expr');
  }
  const sel = JSON.stringify(spec.selector);
  if (typeof spec.textContains === 'string' && spec.textContains) {
    const needle = JSON.stringify(spec.textContains);
    const idx = Number.isInteger(spec.nth) ? spec.nth : 0;
    return 'Array.from(document.querySelectorAll(' + sel + '))' +
      '.filter(function(e){return e.textContent.indexOf(' + needle + ')!==-1;})[' + idx + ']';
  }
  if (Number.isInteger(spec.nth) && spec.nth > 0) {
    return 'document.querySelectorAll(' + sel + ')[' + spec.nth + ']';
  }
  return 'document.querySelector(' + sel + ')';
}

/** Human-readable label for UI cards and error messages. */
function describeSubject(spec) {
  if (!spec) return '';
  if (spec.expr) return 'expr: ' + String(spec.expr).slice(0, 60);
  let s = spec.selector || '';
  if (spec.textContains) s += ' ~"' + spec.textContains + '"';
  else if (Number.isInteger(spec.nth) && spec.nth > 0) s += ' [' + spec.nth + ']';
  return s;
}

module.exports = { compileSubject, describeSubject };
