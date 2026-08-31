'use strict';
/**
 * stage.js — writes a page (plus the camera client and, optionally, a
 * google.script.run shim) to a temp file and returns a file:// URL to
 * navigate Chrome to. NODE-ONLY.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildCameraClientJs } = require('./cameraClient.js');

let stageDir = null;
function ensureStageDir() {
  if (!stageDir) stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-suite-'));
  return stageDir;
}

/**
 * @param {string} name - a short identifier, used only for the filename.
 * @param {string} html - the full page HTML.
 * @param {string} [shimJs] - output of shim.js's buildShimJs(), or omitted
 *   for a page that needs no google.script.run stand-in (e.g. any page with
 *   no client-side server calls, or one you intend to hit live instead).
 * @param {Object} [cameraConfig] - passed through to buildCameraClientJs().
 * @returns {string} a file:// URL.
 */
function stage(name, html, shimJs, cameraConfig) {
  const dir = ensureStageDir();
  const file = path.join(dir, name + '.html');
  const clientJs = '<script>' + buildCameraClientJs(cameraConfig) + '</scr' + 'ipt>';
  fs.writeFileSync(file, html.replace('</body>', (shimJs || '') + clientJs + '</body>'));
  return 'file://' + file;
}

module.exports = { stage: stage };
