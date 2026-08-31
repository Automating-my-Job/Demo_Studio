'use strict';
/**
 * launchChrome.js — spawn headless Chrome and hand back a connected CDP
 * client. Same launch recipe as recorder.js (port 0 + stderr parse, so
 * concurrent runs never collide), extracted so the framing capture can
 * drive a page without recording anything. Reuses demo-suite's cdp.js.
 */
const fs = require('fs');
const { spawn } = require('child_process');

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

function findChrome(explicit) {
  if (explicit) return explicit;
  for (const c of CHROME_CANDIDATES) if (fs.existsSync(c)) return c;
  throw new Error('No Chrome/Chromium found. Set the Chrome path in Settings.');
}

/**
 * @param {{demoSuitePath: string, chromePath?: string, width?: number, height?: number}} opts
 * @returns {Promise<{client: object, close: () => void}>}
 */
async function launchChrome(opts) {
  const { Cdp, httpJson, waitForPort } = require(require('path').join(opts.demoSuitePath, 'lib', 'cdp.js'));
  const W = opts.width || 1920;
  const H = opts.height || 1080;
  const chrome = spawn(findChrome(opts.chromePath), [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--window-size=' + W + ',' + H,
    '--remote-debugging-port=0',
    '--no-first-run', '--no-default-browser-check',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  const port = await new Promise((resolve, reject) => {
    let buf = '';
    const to = setTimeout(() => reject(new Error('Chrome did not report a debug port in time')), 20000);
    chrome.stderr.on('data', d => {
      buf += d.toString();
      const m = /ws:\/\/[^:]+:(\d+)\//.exec(buf);
      if (m) { clearTimeout(to); resolve(Number(m[1])); }
    });
  });

  await waitForPort(port, 20000);
  const targets = await httpJson(port, '/json/list');
  const page = targets.filter(t => t.type === 'page')[0];
  if (!page) { try { chrome.kill(); } catch (err) { /* gone */ } throw new Error('no page target'); }
  const client = await Cdp.connect(page.webSocketDebuggerUrl);
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });

  return {
    client,
    close: () => {
      try { client.close(); } catch (err) { /* already closed */ }
      try { chrome.kill(); } catch (err) { /* already gone */ }
    },
  };
}

module.exports = { launchChrome, findChrome, CHROME_CANDIDATES };
