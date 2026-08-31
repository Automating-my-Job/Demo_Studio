'use strict';
/**
 * readiness.js — waits for a navigated page to actually be ready before
 * shooting. recorder.js's go() only sleeps a blind 1100ms, which is fine for
 * a staged file:// page and not for a live deployment. Polling happens via
 * rec.run with REAL setTimeout sleeps between polls — never rec.hold/settle,
 * which advance film time and would put dead frames in the cut.
 */
const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * @param {object} rec - the recorder primitives (only .run is used).
 * @param {{readySelector?: string, timeoutMs?: number, pollMs?: number, sleepFn?: Function}} [opts]
 */
async function waitForReady(rec, opts) {
  const o = opts || {};
  const timeoutMs = o.timeoutMs || 15000;
  const pollMs = o.pollMs || 250;
  const doSleep = o.sleepFn || sleep;
  const sel = o.readySelector ? JSON.stringify(o.readySelector) : null;
  const expr = '(document.readyState==="complete")' +
    (sel ? ' && !!document.querySelector(' + sel + ')' : '');
  const started = Date.now();
  for (;;) {
    const r = await rec.run(expr);
    if (r && r.result && r.result.value === true) return;
    if (Date.now() - started > timeoutMs) {
      throw new Error('page did not become ready within ' + (timeoutMs / 1000) + 's' +
        (sel ? ' (waiting for ' + o.readySelector + ')' : '') +
        ' — check the URL loads and target.readySelector matches a real element');
    }
    await doSleep(pollMs);
  }
}

module.exports = { waitForReady };
