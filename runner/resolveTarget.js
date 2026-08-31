'use strict';
/**
 * resolveTarget.js — turns a demo.json target into a URL the recorder (or
 * the framing capture) can navigate to. Staged targets go through
 * demo-suite's stage.js, which injects the camera client into the HTML;
 * live URLs get the camera client injected later via rec.run (see
 * executeShots.js) because we do not control their markup.
 */
const fs = require('fs');
const path = require('path');

/**
 * @param {object} demo - normalized demo.json contents.
 * @param {string} projectDir
 * @param {string} demoSuitePath
 * @returns {Promise<{url: string, staged: boolean}>}
 */
async function resolveTarget(demo, projectDir, demoSuitePath) {
  const t = demo.target;
  if (t.kind === 'url') return { url: t.url, staged: false };

  const { stage } = require(path.join(demoSuitePath, 'lib', 'stage.js'));
  let shimJs = null;
  if (t.shim && t.shim.responses) {
    const { buildShimJs } = require(path.join(demoSuitePath, 'lib', 'shim.js'));
    shimJs = buildShimJs(t.shim.responses, t.shim.delayMs);
  }

  let html;
  if (t.kind === 'html') {
    const file = path.resolve(projectDir, t.htmlFile);
    if (!fs.existsSync(file)) throw new Error('target.htmlFile not found: ' + file);
    html = fs.readFileSync(file, 'utf8');
  } else { // render
    const mod = require(path.resolve(projectDir, t.renderModule));
    const fn = typeof mod === 'function' ? mod : (mod && typeof mod.render === 'function' ? mod.render : null);
    if (fn) html = await fn();
    else if (mod && typeof mod.html === 'string') html = mod.html;
    else throw new Error('target.renderModule must export a function, {render}, or {html}: ' + t.renderModule);
    if (typeof html !== 'string' || !html) throw new Error('target.renderModule produced no HTML');
  }
  if (html.indexOf('</body>') === -1) {
    // stage() injects by replacing the first </body> and silently no-ops
    // without one — give the page a body close rather than lose the camera.
    html += '</body>';
  }
  const name = (demo.name || 'page').replace(/[^\w-]+/g, '_');
  return { url: stage(name, html, shimJs, demo.camera), staged: true };
}

module.exports = { resolveTarget };
