'use strict';
/**
 * shim.js — a client-side stand-in for `google.script.run`. NODE-ONLY (this
 * file BUILDS a string of client-side JS).
 *
 * ===========================================================================
 * WHAT IS REAL, WHAT IS STAGED
 * ===========================================================================
 * `google.script.run` exists solely inside a deployed Apps Script page, so a
 * page recorded from a local file or a Node-side render has nothing to
 * answer it. This shim answers with responses YOU computed — normally by
 * calling the project's own server functions directly (e.g. through a Node
 * harness that mocks the Apps Script globals), so every number the demo
 * shows is still real, just delivered over a fake wire instead of a real
 * one.
 *
 * If a project has no such harness, skip this file entirely and point
 * `recorder.go()` at a real deployed URL instead — then `google.script.run`
 * is the browser's real implementation and nothing here is needed.
 *
 * ===========================================================================
 * THE SHIM LOADS AFTER YOUR PAGE'S OWN SCRIPTS — CALL google.script.run
 * FROM AN EVENT HANDLER, NOT AT THE TOP LEVEL
 * ===========================================================================
 * `stage()` appends this shim (and the camera client) right before
 * `</body>`, i.e. AFTER anything already in your page's HTML. A page whose
 * own script calls `google.script.run.xxx()` immediately at parse time will
 * find `window.google` undefined, because the shim that defines it has not
 * run yet. This matches how real Apps Script client code is normally
 * written anyway — a button's `click` listener, not a top-level call — so
 * it is rarely an issue in practice; it only bites a hand-rolled test page
 * that calls it eagerly.
 *
 * ===========================================================================
 * ONE CALL PER FUNCTION NAME MAY NEED MULTIPLE ANSWERS
 * ===========================================================================
 * A page can call the same server function twice in one visit (e.g. an
 * "analyse" step called once for a preview and again after the user edits
 * something). Pass an ARRAY of responses for a function name and each call
 * takes the next one, repeating the last once exhausted — so the page
 * genuinely progresses through a multi-step flow in ONE recorded visit,
 * rather than needing a second navigation with a different canned answer.
 */

/**
 * @param {Object<string, any|any[]>} responses - function name -> one
 *   response, or an array of responses to hand out in order.
 * @param {number} [delayMs=350] - a small delay before resolving, so the
 *   picture can show a "loading" state if the page has one.
 */
function buildShimJs(responses, delayMs) {
  const queues = {};
  Object.keys(responses || {}).forEach(fn => {
    queues[fn] = Array.isArray(responses[fn]) ? responses[fn] : [responses[fn]];
  });
  const wait = delayMs === undefined ? 350 : delayMs;

  const methods = Object.keys(queues).map(fn =>
    JSON.stringify(fn) + ':function(){' +
    ' var q=window.__shimQ[' + JSON.stringify(fn) + '];' +
    ' var r=q[Math.min(window.__shimI[' + JSON.stringify(fn) + '],q.length-1)];' +
    ' window.__shimI[' + JSON.stringify(fn) + ']++;' +
    ' setTimeout(function(){if(h.ok)h.ok(r);},' + wait + ');}'
  ).join(',');

  return '<script>' +
    'window.google={script:{run:(function(){var h={};' +
    'var api={' +
    'withSuccessHandler:function(f){h.ok=f;return api;},' +
    'withFailureHandler:function(f){h.err=f;return api;},' +
    methods +
    '};return api;}())}};' +
    'window.__shimQ=' + JSON.stringify(queues) + ';' +
    'window.__shimI={' + Object.keys(queues).map(fn => JSON.stringify(fn) + ':0').join(',') + '};' +
    '</script>';
}

module.exports = { buildShimJs: buildShimJs };
