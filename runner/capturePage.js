'use strict';
/**
 * capturePage.js — loads the demo's target exactly the way a recording
 * would, then captures what Gemini needs to frame it: a screenshot and a
 * structural outline of the visible DOM. Returns the still-open Chrome
 * session so the framing step can lint proposed selectors against the live
 * page before the user ever sees them.
 */
const fs = require('fs');
const path = require('path');
const { launchChrome } = require('./launchChrome.js');
const { buildOutlineJs } = require('./pageOutline.js');
const { resolveTarget } = require('./resolveTarget.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function evalJs(client, expr) {
  const r = await client.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r && r.exceptionDetails) throw new Error('page eval failed: ' + JSON.stringify(r.exceptionDetails.text));
  return r && r.result ? r.result.value : undefined;
}

async function waitReady(client, readySelector, timeoutMs) {
  const sel = readySelector ? JSON.stringify(readySelector) : null;
  const expr = '(document.readyState==="complete")' + (sel ? ' && !!document.querySelector(' + sel + ')' : '');
  const started = Date.now();
  for (;;) {
    if (await evalJs(client, expr) === true) return;
    if (Date.now() - started > (timeoutMs || 15000)) {
      throw new Error('page did not become ready' + (readySelector ? ' (waiting for ' + readySelector + ')' : ''));
    }
    await sleep(250);
  }
}

/**
 * @param {object} job - {projectDir, demoSuitePath, chromePath, demo}
 * @returns {Promise<{outline: object, screenshotB64: string, capturePath: string,
 *   session: {client, close}, targetUrl: string, staged: boolean}>}
 *   Caller MUST close `session` when done.
 */
async function capturePage(job) {
  const demo = job.demo;
  const target = await resolveTarget(demo, job.projectDir, job.demoSuitePath);
  const session = await launchChrome({
    demoSuitePath: job.demoSuitePath,
    chromePath: job.chromePath,
    width: demo.record.width,
    height: demo.record.height,
  });
  try {
    await session.client.send('Page.navigate', { url: target.url });
    await sleep(600);
    await waitReady(session.client, demo.target.readySelector);

    const shotR = await session.client.send('Page.captureScreenshot', { format: 'jpeg', quality: 65 });
    const capturePath = path.join(job.projectDir, 'demo-out', 'capture.jpg');
    fs.mkdirSync(path.dirname(capturePath), { recursive: true });
    fs.writeFileSync(capturePath, Buffer.from(shotR.data, 'base64'));

    const outlineJson = await evalJs(session.client, buildOutlineJs(400));
    const outline = JSON.parse(outlineJson);
    fs.writeFileSync(path.join(job.projectDir, 'demo-out', 'capture-outline.json'),
      JSON.stringify(outline, null, 2));

    return { outline, screenshotB64: shotR.data, capturePath, session, targetUrl: target.url, staged: target.staged };
  } catch (err) {
    session.close();
    throw err;
  }
}

module.exports = { capturePage, evalJs, waitReady };
